//! Password generation (unbiased, OS CSPRNG) and strength estimation (zxcvbn).

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordOptions {
    pub length: usize,
    pub lowercase: bool,
    pub uppercase: bool,
    pub digits: bool,
    pub symbols: bool,
    pub exclude_ambiguous: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordStrength {
    pub score: u8,
    pub guesses_log10: f64,
    pub crack_time: String,
    pub feedback: Vec<String>,
}

const AMBIGUOUS: &str = "Il1O0o|`'\"";

/// Uniform index in 0..n via rejection sampling (no modulo bias).
fn uniform(n: usize) -> usize {
    assert!(n > 0 && n <= u32::MAX as usize);
    let n = n as u32;
    let zone = u32::MAX - (u32::MAX % n);
    loop {
        let r = getrandom::u32().expect("OS RNG unavailable");
        if r < zone {
            return (r % n) as usize;
        }
    }
}

pub fn generate(o: &PasswordOptions) -> Result<Zeroizing<String>> {
    if !(4..=256).contains(&o.length) {
        return Err(Error::Invalid("length must be between 4 and 256".into()));
    }
    let filter = |s: &str| -> Vec<char> {
        s.chars().filter(|c| !(o.exclude_ambiguous && AMBIGUOUS.contains(*c))).collect()
    };
    let mut classes: Vec<Vec<char>> = vec![];
    if o.lowercase { classes.push(filter("abcdefghijklmnopqrstuvwxyz")); }
    if o.uppercase { classes.push(filter("ABCDEFGHIJKLMNOPQRSTUVWXYZ")); }
    if o.digits { classes.push(filter("0123456789")); }
    if o.symbols { classes.push(filter("!@#$%^&*()-_=+[]{};:,.<>/?~")); }
    if classes.is_empty() {
        return Err(Error::Invalid("select at least one character set".into()));
    }
    let all: Vec<char> = classes.iter().flatten().copied().collect();
    // Guarantee one char from each selected class, fill the rest, then shuffle (Fisher–Yates).
    let mut out: Vec<char> = classes.iter().map(|c| c[uniform(c.len())]).collect();
    while out.len() < o.length {
        out.push(all[uniform(all.len())]);
    }
    for i in (1..out.len()).rev() {
        out.swap(i, uniform(i + 1));
    }
    let s = Zeroizing::new(out.iter().collect::<String>());
    zeroize::Zeroize::zeroize(&mut out);
    Ok(s)
}

pub fn strength(password: &str) -> PasswordStrength {
    let e = zxcvbn::zxcvbn(password, &[]);
    let mut feedback = vec![];
    if let Some(f) = e.feedback() {
        if let Some(w) = f.warning() {
            feedback.push(w.to_string());
        }
        feedback.extend(f.suggestions().iter().map(|s| s.to_string()));
    }
    PasswordStrength {
        score: u8::from(e.score()),
        guesses_log10: e.guesses_log10(),
        crack_time: e.crack_times().offline_slow_hashing_1e4_per_second().to_string(),
        feedback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_requested_classes() {
        let o = PasswordOptions { length: 32, lowercase: true, uppercase: true, digits: true, symbols: false, exclude_ambiguous: true };
        for _ in 0..50 {
            let p = generate(&o).unwrap();
            assert_eq!(p.chars().count(), 32);
            assert!(p.chars().any(|c| c.is_ascii_digit()));
            assert!(p.chars().any(|c| c.is_ascii_uppercase()));
            assert!(!p.chars().any(|c| AMBIGUOUS.contains(c)));
        }
    }

    #[test]
    fn strength_orders() {
        assert!(strength("password").score <= 1);
        assert!(strength("t7#Kq!vR2p@Lx9$wZ").score >= 3);
    }
}
