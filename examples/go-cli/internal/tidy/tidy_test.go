package tidy

import "testing"

func TestName(t *testing.T) {
	if got := Name("My Note"); got != "my-note" {
		t.Fatalf("got %q", got)
	}
}
