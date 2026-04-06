import java.util.List;
import java.util.ArrayList;

public class DataProcessor {
    private List<String> items;

    public DataProcessor() {
        this.items = new ArrayList<>();
    }

    public DataProcessor(List<String> initialItems) {
        this.items = new ArrayList<>(initialItems);
    }

    public DataProcessor(String singleItem, boolean validate) {
        this.items = new ArrayList<>();
        if (validate) {
            this.items.add(singleItem.trim());
        }
    }

    public void addItem(String item) {
        items.add(item);
    }

    public List<String> process() {
        return validate(items);
    }

    private List<String> validate(List<String> data) {
        List<String> result = new ArrayList<>();
        for (String s : data) {
            if (s != null && !s.isEmpty()) {
                result.add(s.trim());
            }
        }
        return result;
    }
}

interface Processor {
    List<String> process();
}
