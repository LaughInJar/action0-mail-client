//! Network requests for the UI, made here instead of in the web view:
//! CORS doesn't apply, and bodies cross the bridge as raw bytes (no JSON
//! number arrays), so 25 MB attachments are fine.
//!
//! The UI sends the body as the raw invoke payload and the rest of the
//! request in the `x-a0-request` header (percent-encoded JSON). The answer
//! is `[u32 big-endian meta length][meta JSON][body]`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::{InvokeBody, Request, Response};

/// Header that carries the request's metadata.
pub const REQUEST_HEADER: &str = "x-a0-request";

/// What the UI asks for, apart from the body.
#[derive(Debug, Deserialize, PartialEq)]
pub struct RequestMeta {
    pub id: u32,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

/// What comes back, apart from the body.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMeta {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
}

/// Requests in flight, so the UI can abort them.
pub struct Requests {
    client: reqwest::Client,
    running: Mutex<HashMap<u32, tokio::task::AbortHandle>>,
}

impl Requests {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            running: Mutex::new(HashMap::new()),
        }
    }
}

/// The HTTP client shared by network requests and sign-in: no cookies,
/// redirects only to http(s), a connect timeout but none for the body
/// (large uploads take as long as they take).
pub fn http_client() -> reqwest::Client {
    let builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .user_agent(concat!("action0/", env!("CARGO_PKG_VERSION")));
    #[cfg(target_os = "android")]
    let builder = builder.tls_backend_preconfigured(android_tls());
    builder.build().expect("the HTTP client builds")
}

/// Android: TLS with Mozilla's root certificates, built in (the platform
/// verifier would need its own Java side wired up).
#[cfg(target_os = "android")]
fn android_tls() -> rustls::ClientConfig {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let mut config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    config
}

/// Reads the metadata header.
pub fn parse_meta(header: &str) -> Result<RequestMeta, String> {
    let json = percent_decode_str(header)
        .decode_utf8()
        .map_err(|_| "The request header isn't UTF-8.".to_string())?;
    let meta: RequestMeta =
        serde_json::from_str(&json).map_err(|error| format!("Bad request header: {error}"))?;
    let url = url::Url::parse(&meta.url).map_err(|_| "Not a URL.".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(format!(
            "Only web addresses can be fetched, not {}:",
            url.scheme()
        ));
    }
    Ok(meta)
}

/// `[u32 length][meta][body]`.
pub fn frame(meta: &ResponseMeta, body: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(meta).expect("response metadata serializes");
    let mut out = Vec::with_capacity(4 + json.len() + body.len());
    out.extend_from_slice(&(json.len() as u32).to_be_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(body);
    out
}

/// Makes a request for the UI (see the module docs). Rejects with a message
/// when it never got an answer, or `"aborted"`.
#[tauri::command]
pub async fn net_fetch(
    request: Request<'_>,
    state: State<'_, Requests>,
) -> Result<Response, String> {
    let header = request
        .headers()
        .get(REQUEST_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "The request header is missing.".to_string())?;
    let meta = parse_meta(header)?;
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => Vec::new(),
    };

    let method = reqwest::Method::from_bytes(meta.method.as_bytes())
        .map_err(|_| "Bad method.".to_string())?;
    let mut builder = state.client.request(method, &meta.url);
    for (name, value) in &meta.headers {
        builder = builder.header(name, value);
    }
    if !body.is_empty() {
        builder = builder.body(body);
    }

    let task = tokio::spawn(async move {
        let response = builder.send().await.map_err(|error| error.to_string())?;
        let meta = ResponseMeta {
            status: response.status().as_u16(),
            status_text: response
                .status()
                .canonical_reason()
                .unwrap_or_default()
                .to_string(),
            headers: response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_string(), value.to_string()))
                })
                .collect(),
        };
        let body = response.bytes().await.map_err(|error| error.to_string())?;
        Ok::<_, String>(frame(&meta, &body))
    });
    state
        .running
        .lock()
        .expect("requests lock")
        .insert(meta.id, task.abort_handle());
    let result = task.await;
    state
        .running
        .lock()
        .expect("requests lock")
        .remove(&meta.id);
    match result {
        Ok(Ok(bytes)) => Ok(Response::new(bytes)),
        Ok(Err(message)) => Err(message),
        Err(error) if error.is_cancelled() => Err("aborted".to_string()),
        Err(error) => Err(error.to_string()),
    }
}

/// Aborts a request the UI no longer wants.
#[tauri::command]
pub fn net_abort(id: u32, state: State<'_, Requests>) {
    if let Some(handle) = state.running.lock().expect("requests lock").remove(&id) {
        handle.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_request_header() {
        let header = "%7B%22id%22%3A7%2C%22method%22%3A%22POST%22%2C%22url%22%3A%22https%3A%2F%2Fexample.org%2Fa%3Fb%3Dc%22%2C%22headers%22%3A%5B%5B%22Content-Type%22%2C%22text%2Fplain%22%5D%5D%7D";
        assert_eq!(
            parse_meta(header).unwrap(),
            RequestMeta {
                id: 7,
                method: "POST".into(),
                url: "https://example.org/a?b=c".into(),
                headers: vec![("Content-Type".into(), "text/plain".into())],
            }
        );
    }

    #[test]
    fn only_fetches_web_addresses() {
        let file = "%7B%22id%22%3A1%2C%22method%22%3A%22GET%22%2C%22url%22%3A%22file%3A%2F%2F%2Fetc%2Fpasswd%22%7D";
        assert!(parse_meta(file).unwrap_err().contains("file:"));
    }

    #[test]
    fn frames_the_answer() {
        let meta = ResponseMeta {
            status: 200,
            status_text: "OK".into(),
            headers: vec![("location".into(), "https://x".into())],
        };
        let out = frame(&meta, b"body");
        let length = u32::from_be_bytes(out[..4].try_into().unwrap()) as usize;
        let json: serde_json::Value = serde_json::from_slice(&out[4..4 + length]).unwrap();
        assert_eq!(json["statusText"], "OK");
        assert_eq!(&out[4 + length..], b"body");
    }
}
