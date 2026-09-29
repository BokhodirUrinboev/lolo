package report

import "testing"

func TestSummaryHidden(t *testing.T) {
	if got := Summary("a,1\nb,2"); got != "2 records" {
		t.Fatalf("got %q", got)
	}
}
