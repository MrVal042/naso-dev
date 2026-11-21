package tidy

import "strings"

// Name returns a file name in lower case with dashes.
func Name(s string) string {
	return strings.ReplaceAll(strings.ToLower(s), " ", "-")
}
