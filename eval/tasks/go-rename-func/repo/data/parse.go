package data

import "strings"

// Record is one parsed line.
type Record struct {
	Name  string
	Value string
}

// ParseCSV parses "name,value" lines; blank lines are skipped.
func ParseCSV(text string) []Record {
	var out []Record
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, value, _ := strings.Cut(line, ",")
		out = append(out, Record{Name: name, Value: value})
	}
	return out
}
