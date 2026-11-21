use slugline::slug;

#[test]
fn joins_words() {
    assert_eq!(slug("Hello World"), "hello-world");
}
