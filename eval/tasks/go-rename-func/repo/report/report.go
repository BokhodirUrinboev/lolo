package report

import (
	"fmt"

	"example.com/app/data"
)

// Summary describes the records in text.
func Summary(text string) string {
	records := data.ParseCSV(text)
	return fmt.Sprintf("%d records", len(records))
}
