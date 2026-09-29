package data

import "testing"

func TestParseRecordsHidden(t *testing.T) {
	if got := ParseRecords("x,9"); len(got) != 1 || got[0].Name != "x" {
		t.Fatalf("got %v", got)
	}
}
