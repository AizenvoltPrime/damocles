<?php

namespace App\Models;

class Camera
{
    public string $name = '';

    public function describe(): string
    {
        return $this->name;
    }
}
