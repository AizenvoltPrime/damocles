<?php

namespace App\Http\Controllers;

use App\Services\Organization\OrganizationContext;

class TenantConsumer
{
    public function resolve(): void
    {
        $ctx = OrganizationContext::get();
    }
}
