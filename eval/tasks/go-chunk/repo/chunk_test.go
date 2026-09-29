package chunk

import (
	"reflect"
	"testing"
)

func TestChunkEven(t *testing.T) {
	got := Chunk([]int{1, 2, 3, 4}, 2)
	if !reflect.DeepEqual(got, [][]int{{1, 2}, {3, 4}}) {
		t.Fatalf("got %v", got)
	}
}
