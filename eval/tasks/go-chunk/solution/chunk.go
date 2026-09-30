package chunk

// Chunk splits xs into consecutive slices of length size; the last one may be shorter.
func Chunk(xs []int, size int) [][]int {
	if size <= 0 {
		return nil
	}
	var out [][]int
	for i := 0; i < len(xs); i += size {
		end := i + size
		if end > len(xs) {
			end = len(xs)
		}
		out = append(out, xs[i:end])
	}
	return out
}
