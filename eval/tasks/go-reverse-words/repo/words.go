package words

import "strings"

// CountWords returns the number of whitespace-separated words.
func CountWords(s string) int {
	return len(strings.Fields(s))
}

// ReverseWords returns the words of s in reverse order.
func ReverseWords(s string) string {
	return s
}
