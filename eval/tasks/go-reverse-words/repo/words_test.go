package words

import "testing"

func TestCountWords(t *testing.T) {
	if got := CountWords("  a b\tc "); got != 3 {
		t.Fatalf("got %d", got)
	}
}
