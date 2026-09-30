class GapWidget {
  def render(): Int = 1
}

object GapRunner {
  def runAll(): Int = {
    val widget = new GapWidget()
    val r = widget.render()
    Registry.lookup(r)
    localHelper(r)
  }

  def buildBare(): GapWidget = new GapWidget

  def localHelper(v: Int): Int = v
}
