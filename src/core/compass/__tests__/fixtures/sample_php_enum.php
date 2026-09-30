<?php

namespace App\Enums;

enum Status
{
    case Active;
    case Inactive;
    case Pending;
}

enum Color: string
{
    case Red = 'red';
    case Blue = 'blue';
}
