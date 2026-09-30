package demo;

class GapService {
    void run() {
        GapWidget widget = new GapWidget();
        Box<GapWidget> box = new Box<GapWidget>();
        widget.render();
        Registry.lookup(1);
        localHelper();
    }

    void localHelper() {
    }
}

class GapWidget {
    void render() {
    }
}
