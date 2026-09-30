class OrganizationService

class Logger

class Repository

class TenantController(service: OrganizationService) {
  val logger: Logger = new Logger

  def resolve(repo: Repository): OrganizationService = service

  def count(value: Int): String = value.toString
}
