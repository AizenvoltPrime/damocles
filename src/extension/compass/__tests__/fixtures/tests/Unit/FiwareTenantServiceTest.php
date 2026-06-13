<?php

namespace Tests\Unit\Services;

use App\Services\Organization\FiwareTenantService;
use App\Services\Organization\OrganizationContext;

class FiwareTenantServiceTest
{
    public function testCreateTenant(): void
    {
        $ctx = OrganizationContext::get();
        $service = new FiwareTenantService($ctx);
    }
}
