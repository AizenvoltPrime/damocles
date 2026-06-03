use std::collections::HashMap;

pub trait Repository {
    fn find_by_id(&self, id: u64) -> Option<&User>;
    fn save(&mut self, user: User);
}

#[derive(Debug, Clone)]
pub struct User {
    pub id: u64,
    pub name: String,
    pub email: String,
}

pub struct InMemoryRepo {
    users: HashMap<u64, User>,
}

impl InMemoryRepo {
    pub fn new() -> Self {
        InMemoryRepo {
            users: HashMap::new(),
        }
    }
}

impl Repository for InMemoryRepo {
    fn find_by_id(&self, id: u64) -> Option<&User> {
        self.users.get(&id)
    }

    fn save(&mut self, user: User) {
        println!("Saving user {}", user.id);
        self.users.insert(user.id, user);
    }
}

pub fn create_user(repo: &mut impl Repository, name: &str, email: &str) -> User {
    let user = User {
        id: 1,
        name: name.to_string(),
        email: email.to_string(),
    };
    repo.save(user.clone());
    user
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_input() {
        let repo = InMemoryRepo::new();
        assert!(repo.find_by_id(1).is_none());
    }

    #[tokio::test]
    async fn async_check() {
        assert_eq!(1 + 1, 2);
    }

    fn build_default_repo() {
        let _ = create_user(&mut InMemoryRepo::new(), "a", "b");
    }

    #[test]
    /// A documented test where the attribute precedes the doc comment.
    fn documented_test() {
        assert_eq!(2 + 2, 4);
    }
}
