package auth

import (
	"errors"
	"fmt"
)

type User struct {
	ID    int
	Name  string
	Email string
}

type UserRepository interface {
	FindByID(id int) (*User, error)
	Save(user *User) error
}

type InMemoryRepo struct {
	users map[int]*User
}

func NewInMemoryRepo() *InMemoryRepo {
	return &InMemoryRepo{users: make(map[int]*User)}
}

func (r *InMemoryRepo) FindByID(id int) (*User, error) {
	user, ok := r.users[id]
	if !ok {
		return nil, errors.New("user not found")
	}
	return user, nil
}

func (r *InMemoryRepo) Save(user *User) error {
	r.users[user.ID] = user
	fmt.Printf("Saved user %d\n", user.ID)
	return nil
}

func CreateUser(repo UserRepository, name string, email string) (*User, error) {
	user := &User{ID: 1, Name: name, Email: email}
	err := repo.Save(user)
	if err != nil {
		return nil, err
	}
	return user, nil
}
