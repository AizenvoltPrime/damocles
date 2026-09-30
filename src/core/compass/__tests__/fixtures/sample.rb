require 'json'
require 'net/http'
require_relative 'helpers'

module Networking
  class ApiClient
    def initialize(base_url)
      @base_url = base_url
    end

    def get(path)
      fetch(path, 'GET')
    end

    def post(path, body)
      fetch(path, 'POST')
    end

    private

    def fetch(path, method)
      uri = URI(@base_url + path)
      Net::HTTP.get(uri)
    end
  end

  class ResponseParser
    def parse(raw)
      JSON.parse(raw)
    end
  end
end

def parse_response(raw)
  JSON.parse(raw)
end
