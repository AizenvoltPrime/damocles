<?php

namespace App\Services\Organization;

class OrganizationContext
{
    public static function get(): self
    {
        return new OrganizationContext();
    }
}

class FiwareTenantService
{
    public function __construct($ctx)
    {
    }
}
