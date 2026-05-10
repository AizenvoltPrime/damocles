public class MethodNameSample {
    private String value;

    public MethodNameSample(String value) {
        this.value = value;
    }

    public String getName() {
        return value;
    }

    public void setName(String value) {
        this.value = value;
    }

    public static List<String> buildAll(int count) {
        return new ArrayList<>();
    }

    public <T> T identity(T input) {
        return input;
    }
}
