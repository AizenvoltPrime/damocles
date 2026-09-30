namespace Demo
{
    public class OrganizationService
    {
    }

    public class Logger
    {
    }

    public class Repository
    {
    }

    public class TenantController
    {
        private Logger _logger;
        public Repository Repo { get; set; }

        public TenantController(OrganizationService service)
        {
        }

        public OrganizationService Resolve(Repository repo)
        {
            return null;
        }

        public string Count(int value)
        {
            return value.ToString();
        }

        public System.Threading.Tasks.Task<Repository> LoadAsync()
        {
            return null;
        }
    }
}
