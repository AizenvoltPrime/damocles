<?php

namespace App\Services;

use App\Services\Organization\OrganizationContext;

class FiwareTenantService
{
    public function __construct($ctx)
    {
    }

    public static function make(): self
    {
        return FiwareTenantService::fromDefaults();
    }

    public static function fromDefaults(): self
    {
        return new FiwareTenantService(null);
    }

    public function resolveTenant(): void
    {
        $ctx = OrganizationContext::get();
        $service = new FiwareTenantService($ctx);
        Foo\Bar::baz();
        $name = OrganizationContext::class;
        $gate = TenantGate::class;
        $made = self::make();
        $cls = 'App\\Services\\FiwareTenantService';
        $dynamic = new $cls();
    }
}
