<?php

namespace App\Checks;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;

class TenantServiceCheck
{
    #[Test]
    public function createsTenant(): void
    {
        $this->helperMethod();
    }

    #[\PHPUnit\Framework\Attributes\Test]
    public function removesTenant(): void
    {
        $this->helperMethod();
    }

    #[DataProvider('tenantProvider'), Test]
    public function updatesTenant(string $name): void
    {
        $this->helperMethod();
    }

    public function helperMethod(): void
    {
    }
}
