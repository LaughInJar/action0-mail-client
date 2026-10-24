//! The local address the browser comes back to after signing in: a tiny
//! one-shot HTTP server on 127.0.0.1 (and ::1, for browsers that resolve
//! `localhost` to it) at a random port.

use std::collections::HashMap;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The texts of the page the browser shows afterwards.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct PageTexts {
    /// Shown when the sign-in went through.
    pub done: String,
    /// Shown when it didn't.
    pub failed: String,
}

/// A listener waiting for the browser.
pub struct Loopback {
    v4: TcpListener,
    v6: Option<TcpListener>,
    pub port: u16,
}

impl Loopback {
    /// Listens on a free port of 127.0.0.1 (and the same one on ::1 if it can).
    pub async fn bind() -> std::io::Result<Self> {
        let v4 = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = v4.local_addr()?.port();
        let v6 = TcpListener::bind(("::1", port)).await.ok();
        Ok(Self { v4, v6, port })
    }

    /// Waits for the browser to come back to `path` with a `state` and
    /// answers with the page; other requests (a favicon) get a 404. Returns
    /// the query parameters of the callback.
    pub async fn wait(
        &self,
        path: &str,
        texts: &PageTexts,
    ) -> std::io::Result<HashMap<String, String>> {
        loop {
            let (mut stream, _) = match &self.v6 {
                Some(v6) => tokio::select! {
                    accepted = self.v4.accept() => accepted?,
                    accepted = v6.accept() => accepted?,
                },
                None => self.v4.accept().await?,
            };
            let Some(target) = read_target(&mut stream).await else {
                continue;
            };
            match callback_params(&target, path) {
                Some(params) => {
                    let ok = params.contains_key("code") && !params.contains_key("error");
                    let text = if ok { &texts.done } else { &texts.failed };
                    respond(&mut stream, "200 OK", &page(text)).await;
                    return Ok(params);
                }
                None => respond(&mut stream, "404 Not Found", "").await,
            }
        }
    }
}

/// The request target of an HTTP request head (`GET <target> HTTP/1.1`).
async fn read_target(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut buffer = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < 16 * 1024 {
        let read = stream.read(&mut buffer).await.ok()?;
        if read == 0 {
            break;
        }
        head.extend_from_slice(&buffer[..read]);
    }
    request_target(&String::from_utf8_lossy(&head))
}

/// The target of a GET request's first line.
pub fn request_target(head: &str) -> Option<String> {
    let line = head.lines().next()?;
    let mut parts = line.split(' ');
    match (parts.next(), parts.next()) {
        (Some("GET"), Some(target)) => Some(target.to_string()),
        _ => None,
    }
}

/// The query of a callback to `path`: only requests with a `state`.
pub fn callback_params(target: &str, path: &str) -> Option<HashMap<String, String>> {
    let url = url::Url::parse(&format!("http://localhost{target}")).ok()?;
    if url.path() != path {
        return None;
    }
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    params.contains_key("state").then_some(params)
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// The page shown after signing in: just the text, no scripts.
pub fn page(text: &str) -> String {
    let text = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>action0</title><style>body{{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#18181b;background:#fafafa}}@media(prefers-color-scheme:dark){{body{{color:#f4f4f5;background:#18181b}}}}p{{max-width:28rem;text-align:center;line-height:1.5}}</style></head><body><p>{text}</p></body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_target_of_a_get() {
        assert_eq!(
            request_target("GET /desktop?code=1&state=x HTTP/1.1\r\nHost: localhost\r\n\r\n"),
            Some("/desktop?code=1&state=x".into())
        );
        assert_eq!(request_target("POST / HTTP/1.1\r\n\r\n"), None);
    }

    #[test]
    fn takes_only_callbacks_to_its_path() {
        let params = callback_params("/desktop?code=a%2Fb&state=s1", "/desktop").unwrap();
        assert_eq!(params["code"], "a/b");
        assert_eq!(params["state"], "s1");
        assert!(callback_params("/favicon.ico", "/desktop").is_none());
        assert!(callback_params("/desktop?code=1", "/desktop").is_none());
        assert!(callback_params("/?error=access_denied&state=s", "/").is_some());
    }

    #[test]
    fn escapes_the_page_text() {
        assert!(page("<b>").contains("&lt;b&gt;"));
    }

    #[tokio::test]
    async fn answers_the_browser() {
        let loopback = Loopback::bind().await.unwrap();
        let port = loopback.port;
        let browser = tokio::spawn(async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream
                .write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            let mut answer = String::new();
            stream.read_to_string(&mut answer).await.unwrap();
            assert!(answer.starts_with("HTTP/1.1 404"));
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream
                .write_all(b"GET /?code=c&state=s HTTP/1.1\r\nHost: x\r\n\r\n")
                .await
                .unwrap();
            let mut answer = String::new();
            stream.read_to_string(&mut answer).await.unwrap();
            answer
        });
        let texts = PageTexts {
            done: "Signed in".into(),
            failed: "No".into(),
        };
        let params = loopback.wait("/", &texts).await.unwrap();
        assert_eq!(params["code"], "c");
        assert!(browser.await.unwrap().contains("Signed in"));
    }
}
