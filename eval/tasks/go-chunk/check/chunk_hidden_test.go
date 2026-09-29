package chunk

import (
	"reflect"
	"testing"
)

func TestChunkHidden(t *testing.T) {
	if got := Chunk([]int{1, 2, 3, 4, 5}, 2); !reflect.DeepEqual(got, [][]int{{1, 2}, {3, 4}, {5}}) {
		t.Fatalf("partial: got %v", got)
	}
	if got := Chunk([]int{1, 2}, 5); !reflect.DeepEqual(got, [][]int{{1, 2}}) {
		t.Fatalf("size > len: got %v", got)
	}
	if got := Chunk([]int{1, 2}, 0); got != nil {
		t.Fatalf("size 0: got %v", got)
	}
	if got := Chunk(nil, 3); len(got) != 0 {
		t.Fatalf("empty: got %v", got)
	}
}
