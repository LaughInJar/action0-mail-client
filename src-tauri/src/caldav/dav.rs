//! The little WebDAV XML the walk to a user's calendars needs: PROPFIND
//! bodies, and hrefs out of a `multistatus` answer. The rest of DAV is the
//! UI's.

/// The DAV namespace.
pub const DAV: &str = "DAV:";
/// The CalDAV namespace (RFC 4791).
pub const CALDAV: &str = "urn:ietf:params:xml:ns:caldav";

/// A PROPFIND body asking for `props` (`(namespace, name)`).
pub fn propfind(props: &[(&str, &str)]) -> String {
    let props: String = props
        .iter()
        .map(|(namespace, name)| {
            let prefix = if *namespace == CALDAV { "c" } else { "d" };
            format!("<{prefix}:{name}/>")
        })
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>{props}</d:prop></d:propfind>"#
    )
}

/// The hrefs inside the property `(namespace, name)` of a `multistatus`
/// answer (in document order); none if it's missing or the XML is broken.
pub fn hrefs(xml: &str, namespace: &str, name: &str) -> Vec<String> {
    let Ok(document) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };
    document
        .descendants()
        .filter(|node| node.has_tag_name((namespace, name)))
        .flat_map(|property| {
            property
                .descendants()
                .filter(|node| node.has_tag_name((DAV, "href")))
                .filter_map(|href| href.text())
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_for_properties() {
        let body = propfind(&[
            (DAV, "current-user-principal"),
            (CALDAV, "calendar-home-set"),
        ]);
        assert!(
            body.contains("<d:prop><d:current-user-principal/><c:calendar-home-set/></d:prop>")
        );
        assert!(roxmltree::Document::parse(&body).is_ok());
    }

    #[test]
    fn reads_hrefs_whatever_the_prefixes() {
        let xml = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response><href>/dav/principals/me/</href>
    <propstat><prop>
      <C:calendar-home-set><href> /dav/calendars/me/ </href></C:calendar-home-set>
      <C:calendar-user-address-set>
        <href>/dav/principals/me/</href><href>mailto:me@example.org</href>
      </C:calendar-user-address-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>"#;
        assert_eq!(
            hrefs(xml, CALDAV, "calendar-home-set"),
            ["/dav/calendars/me/"]
        );
        assert_eq!(
            hrefs(xml, CALDAV, "calendar-user-address-set"),
            ["/dav/principals/me/", "mailto:me@example.org"]
        );
        assert!(hrefs(xml, DAV, "current-user-principal").is_empty());
        assert!(hrefs("<broken", DAV, "href").is_empty());
    }
}
