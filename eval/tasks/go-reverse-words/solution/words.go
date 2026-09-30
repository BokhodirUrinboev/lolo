package words

import "strings"

// CountWords returns the number of whitespace-separated words.
func CountWords(s string) int {
	return len(strings.Fields(s))
}

// ReverseWords returns the words of s in reverse order.
func ReverseWords(s string) string {
	f := strings.Fields(s)
	for i, j := 0, len(f)-1; i < j; i, j = i+1, j-1 {
		f[i], f[j] = f[j], f[i]
	}
	return strings.Join(f, " ")
}
