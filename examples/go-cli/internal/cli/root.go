package cli

import "github.com/spf13/cobra"

// Root is the tidy command.
func Root() *cobra.Command {
	return &cobra.Command{Use: "tidy", Short: "Tidy a folder of notes"}
}
