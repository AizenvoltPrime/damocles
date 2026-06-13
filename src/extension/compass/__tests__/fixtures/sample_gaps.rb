class GapClient
  def fetch
    svc = GapService.new
    svc.submit(self)
    Registry.lookup(1)
    Admin::Portal.open
    builder = factory.new
    local_helper(1)
  end

  def local_helper(x)
  end
end

class GapService
  def submit(arg)
  end
end
