struct GapWidget {
    id: u32,
}

impl GapWidget {
    fn new() -> GapWidget {
        GapWidget { id: 1 }
    }

    fn fresh() -> GapWidget {
        Self::new()
    }

    fn render(&self) -> u32 {
        self.id
    }
}

fn build_all() -> u32 {
    let widget = GapWidget::new();
    let direct = GapWidget { id: 2 };
    let other = registry::Tracker::create();
    let _ = other;
    let _ = GapWidget::fresh();
    widget.render() + direct.id
}
