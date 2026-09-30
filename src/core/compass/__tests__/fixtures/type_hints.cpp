class OrganizationService {
};

class Logger {
};

class Repository {
};

class TenantController {
    Logger logger;

public:
    TenantController(OrganizationService service) {
    }

    OrganizationService resolve(Repository repo) {
        return OrganizationService();
    }

    int count(int value) {
        return value;
    }
};
