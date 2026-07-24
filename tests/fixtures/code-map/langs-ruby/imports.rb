require 'sinatra'
require "json"
require_relative './helpers'
require 'active_support/core_ext'

puts "not an import"

def use
  JSON.parse("{}")
end
