package widget

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

func use() {
	fmt.Println(strings.ToUpper("x"))
	_ = cobra.Command{}
}
