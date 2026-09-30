class OrganizationService:
    pass


class Logger:
    pass


class Repository:
    pass


class TenantController:
    def __init__(self, service: OrganizationService):
        self.service = service

    def resolve(self, repo: Repository) -> OrganizationService:
        return self.service

    def count(self, value: int) -> str:
        return str(value)
