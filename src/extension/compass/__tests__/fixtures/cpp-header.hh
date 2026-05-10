#pragma once

#include <string>

namespace networking {

class Connection {
public:
    Connection(const std::string& host, int port);
    ~Connection();

    bool open();
    void close();
    std::string send(const std::string& payload);

private:
    std::string host_;
    int port_;
    bool isOpen_;
};

}
