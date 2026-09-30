import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;

class TenantServiceCheck {
    @Test
    void createsTenant() {
        helperMethod();
    }

    @ParameterizedTest
    void handlesManyInputs(String input) {
        helperMethod();
    }

    @RepeatedTest(3)
    void retriesFlakyPath() {
        helperMethod();
    }

    @Override
    public String toString() {
        return "check";
    }

    void helperMethod() {
    }
}
