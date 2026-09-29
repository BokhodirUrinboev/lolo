package words

import "testing"

func TestReverseWordsHidden(t *testing.T) {
	cases := map[string]string{"one two three": "three two one", "  hi   there \n": "there hi", "": "", "solo": "solo"}
	for in, want := range cases {
		if got := ReverseWords(in); got != want {
			t.Errorf("ReverseWords(%q) = %q, want %q", in, got, want)
		}
	}
}
