import java.util.List;
import java.util.ArrayList;
import com.example.auth.User;
import java.util.*;
import static java.util.Map.entry;

public class FooRepository extends BaseRepository implements UserRepository, Comparable<FooRepository> {
    private List<String> items;

    public FooRepository() {
        this.items = new ArrayList<>();
    }

    public int compareTo(FooRepository other) {
        return 0;
    }
}

interface UserRepository {
    User findById(int id);
}

abstract class BaseRepository {
    abstract void save();
}
