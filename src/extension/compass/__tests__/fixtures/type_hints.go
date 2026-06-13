package demo

type OrganizationService struct {
}

type Logger struct {
}

type Repository struct {
}

type TenantController struct {
	logger *Logger
}

func NewController(service *OrganizationService) *TenantController {
	return &TenantController{}
}

func (c *TenantController) Resolve(repo Repository) *OrganizationService {
	return nil
}

func (c *TenantController) Count(value int) string {
	return ""
}
