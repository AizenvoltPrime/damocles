class GapWidget {
public:
    static int spawnCount();
    int render();
};

int GapWidget::spawnCount() { return 1; }

int GapWidget::render() { return 2; }

int helperFun(int total) { return total; }

int runAll() {
    GapWidget* widget = new GapWidget();
    ns::Tracker* tracker = new ns::Tracker();
    int c = GapWidget::spawnCount();
    int r = widget->render();
    (void)tracker;
    return helperFun(c + r);
}
