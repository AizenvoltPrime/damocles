package gaps

type GapWidget struct {
	id int
}

func (w *GapWidget) Render() int {
	return w.id
}

func buildWidget() int {
	w := GapWidget{id: 1}
	p := &GapWidget{id: 2}
	s := store.Item{}
	total := w.Render() + p.Render() + gapHelper()
	_ = s
	return total
}

func gapHelper() int {
	return 0
}
