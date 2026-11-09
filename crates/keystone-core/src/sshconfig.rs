//! Minimal OpenSSH client-config parser for importing hosts.
//! Supports: Host (concrete aliases only; wildcard patterns are skipped), HostName,
//! User, Port, IdentityFile, ProxyJump. Other directives are ignored.

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Entry {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Vec<String>,
}

fn expand_tilde(p: &str) -> String {
    match (p.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => p.to_owned(),
    }
}

pub fn parse(text: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = vec![];
    let mut current: Vec<usize> = vec![];
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, val) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_owned()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in val.split_whitespace() {
                    if alias.contains(['*', '?', '!']) {
                        continue;
                    }
                    out.push(Entry { alias: alias.to_owned(), ..Default::default() });
                    current.push(out.len() - 1);
                }
            }
            "match" => current.clear(),
            _ => {
                for &i in &current {
                    let e = &mut out[i];
                    // First obtained value wins, as in OpenSSH.
                    match key.as_str() {
                        "hostname" if e.hostname.is_none() => e.hostname = Some(val.clone()),
                        "user" if e.user.is_none() => e.user = Some(val.clone()),
                        "port" if e.port.is_none() => e.port = val.parse().ok(),
                        "identityfile" if e.identity_file.is_none() => e.identity_file = Some(expand_tilde(&val)),
                        "proxyjump" if e.proxy_jump.is_empty() && !val.eq_ignore_ascii_case("none") => {
                            // user@host:port forms are reduced to the alias/host part.
                            e.proxy_jump = val
                                .split(',')
                                .map(|j| {
                                    let j = j.trim();
                                    let j = j.rsplit_once('@').map(|(_, h)| h).unwrap_or(j);
                                    j.split(':').next().unwrap_or(j).to_owned()
                                })
                                .collect();
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_blocks() {
        let e = super::parse("Host a b\n HostName=x.example\n User root\nHost *.corp\n User nobody\nHost c\n ProxyJump u@a:22,b\n");
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].hostname.as_deref(), Some("x.example"));
        assert_eq!(e[1].user.as_deref(), Some("root"));
        assert_eq!(e[2].proxy_jump, vec!["a", "b"]);
    }
}
