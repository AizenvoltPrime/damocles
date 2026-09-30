package demo

class GapWidget(val id: Int) {
    fun render(): Int {
        val service = GapService()
        service.transform(id)
        Registry.lookup(id)
        helperFun()
        return id
    }
}

class GapService {
    fun transform(value: Int): Int = value
}

object Registry {
    fun lookup(id: Int): Int = id
}

fun helperFun() {}
