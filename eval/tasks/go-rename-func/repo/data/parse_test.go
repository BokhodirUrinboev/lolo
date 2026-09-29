package data

import "testing"

func TestParseCSV(t *testing.T) {
	got := ParseCSV("a,1\n\nb,2\n")
	if len(got) != 2 || got[1].Value != "2" {
		t.Fatalf("got %v", got)
	}
}
