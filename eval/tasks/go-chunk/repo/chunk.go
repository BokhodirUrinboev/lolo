package chunk

// Chunk splits xs into consecutive slices of length size; the last one may be shorter.
func Chunk(xs []int, size int) [][]int {
	var out [][]int
	for i := 0; i+size <= len(xs); i += size {
		out = append(out, xs[i:i+size])
	}
	return out
}
