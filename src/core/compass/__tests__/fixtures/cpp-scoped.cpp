class Foo {
public:
    Foo();
    ~Foo();
    void bar();
    bool operator==(const Foo& other) const;
};

namespace A {
namespace B {
namespace C {
    void deep();
}
}
}

void Foo::bar() {
    return;
}

Foo::~Foo() {
}

bool Foo::operator==(const Foo& other) const {
    return true;
}

void A::B::C::deep() {
}
