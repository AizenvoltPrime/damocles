class OrganizationService

class Logger

class Repository

class TenantController(private val service: OrganizationService) {
    private val logger: Logger = Logger()

    fun resolve(repo: Repository): OrganizationService {
        return service
    }

    fun count(value: Int): String {
        return value.toString()
    }
}
