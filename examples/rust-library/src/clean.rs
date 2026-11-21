/// A lower-case slug with dashes.
pub fn slug(title: &str) -> String {
    title
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join("-")
}
