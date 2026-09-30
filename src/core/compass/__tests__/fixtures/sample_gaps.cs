namespace Demo
{
    public class GapService
    {
        public void Run()
        {
            var widget = new GapWidget();
            var box = new Box<int>();
            var nested = new Outer.Inner();
            widget.Render();
            Registry.Lookup(1);
            LocalHelper();
        }

        private void LocalHelper()
        {
        }
    }

    public class GapWidget
    {
        public void Render()
        {
        }
    }
}
