package main

import (
	"os"

	"example.invalid/tidy/internal/cli"
)

func main() {
	if err := cli.Root().Execute(); err != nil {
		os.Exit(1)
	}
}
